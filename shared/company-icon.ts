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
