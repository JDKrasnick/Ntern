/**
 * Proactive infinite scroll.
 *
 * Waiting for the bottom edge of a feed to appear makes every page boundary a
 * visible stall: the reader hits the end, watches a spinner, then the page
 * arrives. Instead we ask for the next page once the reader has scrolled
 * through `fraction` of what is already loaded, so fresh roles are usually in
 * place before the seam is ever reached.
 *
 * `fraction` is measured against the scrollable length
 * (`contentHeight - viewportHeight`), not the viewport, so "half the page"
 * means half of the content the reader can actually travel through.
 */
export const proactivePrefetchFraction = 0.5;

export function shouldPrefetchNextPage(input: {
  contentOffsetY: number;
  contentHeight: number;
  viewportHeight: number;
  loading: boolean;
  reachedEnd: boolean;
  errored: boolean;
  fraction?: number;
}) {
  if (input.loading || input.reachedEnd || input.errored) return false;
  const scrollable = input.contentHeight - input.viewportHeight;
  // A list shorter than the viewport cannot be scrolled, so anything still
  // unseen would be unreachable. Keep filling it.
  if (scrollable <= 0) return true;
  return input.contentOffsetY >= scrollable * (input.fraction ?? proactivePrefetchFraction);
}
