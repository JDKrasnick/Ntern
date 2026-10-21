/**
 * Deterministic monogram identity for a canonical employer.
 *
 * A monogram is what the catalog renders whenever no reviewed or automatically
 * resolved company logo exists. It must stay stable for the same employer: the
 * palette index is derived from the canonical employer ID rather than from the
 * display name, which reviewers can rename, so a rename never changes the tile a
 * reader already associates with a company.
 *
 * This module is browser-safe and shared by the API, the Worker, and the Expo
 * client so both ends derive the same tile from the same identity.
 */

/** Six low-saturation tints, ordered so adjacent indices stay distinguishable. */
export const companyMonogramColors = ['#E6F6F8', '#F0E8FF', '#FFF0E7', '#E8F5EA', '#E8EEFF', '#FCE8F1'] as const;

/**
 * First letters of the first two words. Hyphens, underscores, and whitespace all
 * separate words, so the slug `acme-labs` and the name `Acme Labs` agree.
 */
export function companyMonogramInitials(label: string): string {
  const words = label.trim().split(/[\s\-_]+/u).filter(Boolean);
  return words.slice(0, 2).map((word) => word.slice(0, 1).toUpperCase()).join('') || '?';
}

/** Stable palette index for one canonical employer identity. */
export function companyMonogramColorIndex(canonicalEmployerId: string): number {
  let total = 0;
  for (const character of canonicalEmployerId) total += character.codePointAt(0) ?? 0;
  return total % companyMonogramColors.length;
}

/** The brand is part of the identity: one ATS account can host several brands. */
export function companyIconName(company: string): string {
  const words = company.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ').trim().split(/\s+/u);
  const suffixes = new Set(['co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'limited', 'llc', 'ltd', 'plc']);
  while (words.length > 1 && suffixes.has(words.at(-1)!)) words.pop();
  return words.join(' ');
}

/** Browser-safe cache key, independent of employer admission or ranking identity.
 * Keep the complete hostname and the ATS board/site path to separate regional
 * sites and brands. Job IDs and tracking parameters never affect this key.
 */
export function companyIconIdentity(company: string, applicationUrl: string): { id: string; scope: string; name: string } | undefined {
  let url: URL;
  try { url = new URL(applicationUrl); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  const name = companyIconName(company);
  if (!name) return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./u, '');
  const path = url.pathname.split('/').filter(Boolean);
  const board = /(^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com)$/u.test(host)
    ? path[0]?.toLowerCase() ?? ''
    : /\.myworkdayjobs\.com$/u.test(host)
      ? path.filter((part) => !/^[a-z]{2}-[A-Z]{2}$/u.test(part))[0]?.toLowerCase() ?? '' : '';
  const platformHost = /(^|\.)greenhouse\.io$/u.test(host) ? 'greenhouse.io'
    : /(^|\.)lever\.co$/u.test(host) ? 'lever.co' : host;
  const scope = `${platformHost}${board ? `/${board}` : ''}`;
  // Two independently seeded 64-bit FNV hashes. This is a cache identity, never
  // an authorization token. Including the name also prevents tenant-wide reuse.
  const value = `${name}|${scope}`;
  const hash = (seed: bigint) => {
    let result = seed;
    for (const character of value) result = BigInt.asUintN(64, (result ^ BigInt(character.codePointAt(0)!)) * 1099511628211n);
    return result.toString(16).padStart(16, '0');
  };
  return { id: `icon-v1-${hash(14695981039346656037n)}${hash(7809847782465536322n)}`, scope, name };
}
