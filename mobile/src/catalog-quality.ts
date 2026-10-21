import { compensationLabels, type DisplayCompensation } from '../../shared/compensation-display';
import { educationLevelLabels, educationLevels } from '../../shared/education-display';
import { postingFactSummaries } from '../../shared/posting-fact-display';
import type { PostingFact } from '../../shared/posting-facts';
export { compensationLabels };

export function catalogMetadataTags(seasons: string[], education: Array<{ levels: string[]; evidence: string }>, postingFacts?: readonly PostingFact[]) {
  const tags: Array<{ label: string; kind: 'season' | 'education' | 'neutral' }> = [];
  for (const season of new Set(seasons)) {
    const label = boundedCatalogText(season, 80).replace(/-/gu, ' ').replace(/^\w/u, letter => letter.toUpperCase());
    if (label && !/^(ongoing|unspecified|season not specified)$/iu.test(label)) tags.push({ label, kind: 'season' });
  }
  if (!tags.length) tags.push({ label: 'Season unspecified', kind: 'neutral' });
  for (const audience of education) {
    if (audience.evidence === 'conflicting') {
      tags.push({ label: 'Education unclear', kind: 'neutral' });
      continue;
    }
    if (audience.evidence !== 'explicit' && audience.evidence !== 'inferred') continue;
    for (const level of educationLevels) {
      if (audience.levels.includes(level)) tags.push({ label: `${educationLevelLabels[level]}${audience.evidence === 'inferred' ? ' (inferred)' : ''}`, kind: 'education' });
    }
  }
  if (!tags.some(tag => tag.kind === 'education' || tag.label === 'Education unclear')) {
    const summary = postingFactSummaries(postingFacts).find(fact => fact.field === 'education');
    const generic = summary?.tags.find(label => ['Pursuing degree', 'Pursuing engineering degree', 'Enrolled'].includes(label));
    tags.push(generic
      ? { label: generic === 'Pursuing engineering degree' ? 'Pursuing degree' : generic, kind: 'education' }
      : { label: 'Education unspecified', kind: 'neutral' });
  }
  return tags.filter((tag, index) => tags.findIndex(other => other.label === tag.label) === index);
}

export function boundedCatalogText(value: unknown, maximum: number): string {
  const clean = typeof value === "string" ? value.normalize("NFC").replace(/\s+/gu, " ").trim() : "";
  if ([...clean].length <= maximum) return clean;
  const slice = [...clean].slice(0, maximum + 1).join("");
  const boundary = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf(" · "), slice.lastIndexOf(", "));
  return [...(boundary > maximum * 0.65 ? slice.slice(0, boundary) : slice)].slice(0, maximum).join("").trim();
}

export function compactLocations(values: unknown, fallback?: unknown): string {
  const candidates = Array.isArray(values) ? values : typeof fallback === "string" ? fallback.split(/\s*(?:\n|\||;|\s\/\s)\s*/u) : [];
  const unique = [...new Set(candidates.map((item) => boundedCatalogText(item, 120)).filter(Boolean))].slice(0, 12);
  if (!unique.length) return "Location not specified";
  return boundedCatalogText(`${unique.slice(0, 2).join(" · ")}${unique.length > 2 ? ` + ${unique.length - 2} more` : ""}`, 160);
}

/** A stable one-line location for dense catalog cards; expanded details retain every site. */
export function compactCatalogLocation(values: unknown, fallback?: unknown): string {
  const candidates = Array.isArray(values) ? values : typeof fallback === "string" ? fallback.split(/\s*(?:\n|\||;|\s\/\s)\s*/u) : [];
  const primary = boundedCatalogText(candidates.find((item): item is string => typeof item === "string" && Boolean(item.trim())), 120);
  if (!primary) return "Location not specified";
  const parts = primary.split(",").map((part) => part.trim()).filter(Boolean);
  // A postal address often reads "City, building/address, country". Keeping
  // the ends preserves the useful geographic answer without the address noise.
  if (parts.length >= 3) {
    const first = parts[0]!;
    const last = parts.at(-1)!;
    // Some ATS feeds prefix the country before the city ("China, Beijing,
    // China"). Treat the repeated country as an envelope, not as a city, so
    // compact cards do not collapse into "China, China".
    if (first.localeCompare(last, undefined, { sensitivity: "accent" }) === 0) {
      return boundedCatalogText(`${parts[1]}, ${last}`, 64);
    }
    return boundedCatalogText(`${first}, ${last}`, 64);
  }
  return boundedCatalogText(primary, 64);
}

/** Keep dense card titles within a predictable two-line reading budget. */
export function compactCatalogTitle(value: unknown): string {
  const clean = typeof value === "string" ? value.normalize("NFC").replace(/\s+/gu, " ").trim() : "";
  const compact = boundedCatalogText(clean, 72);
  return compact && compact !== clean ? `${compact}…` : compact;
}

export function seasonLabel(value: unknown): string {
  const season = boundedCatalogText(value, 80);
  return !season || season.toLowerCase() === "ongoing" ? "Season not specified" : season;
}

/** Keep the term in the title only once, including legacy machine-formatted seasons. */
export function roleSheetTitle(title: string, season: unknown): string {
  const term = boundedCatalogText(season, 80);
  if (!term || /^(?:ongoing|unspecified|season not specified)$/iu.test(term)) return title;
  const comparable = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/gu, '');
  if (comparable(title).includes(comparable(term))) return title;
  const formatted = term.replace(/-/gu, ' ').replace(/^\w/u, letter => letter.toUpperCase());
  return `${title} · ${formatted}`;
}

export function presentCatalogRole<T extends { company?: unknown; title?: unknown; location?: unknown; locations?: unknown; season?: unknown; compensation?: DisplayCompensation }>(role: T) {
  return {
    company: boundedCatalogText(role.company, 160) || "Unknown company",
    title: boundedCatalogText(role.title, 240) || "Role title unavailable",
    location: compactLocations(role.locations, role.location),
    season: seasonLabel(role.season),
    compensation: compensationLabels(role.compensation).join(' · '),
  };
}
