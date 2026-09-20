/**
 * Keeps the searchable catalog dense on the web without squeezing cards on
 * phones and tablets. The release rail has its own fixed-width presentation.
 */
export function catalogGridColumnCount(width: number) {
  if (width >= 1680) return 6;
  if (width >= 1100) return 5;
  if (width >= 840) return 4;
  if (width >= 560) return 2;
  return 1;
}
