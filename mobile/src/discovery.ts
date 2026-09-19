/**
 * The Discover deck's order: the roles that just matched the reader first, then
 * the rest of the open catalog in the order the catalog served it, with a role
 * that arrives in both halves kept once — where it landed first.
 *
 * Nothing is remembered between sessions, so the deck always starts from its
 * top card. What the reader has already decided is not this function's business:
 * the deck drops hidden and queued roles when it renders.
 */
export function discoveryDeck<T extends { jobId: string }>(
  newMatches: readonly T[],
  openRoles: readonly T[],
): T[] {
  const deck: T[] = [];
  const seen = new Set<string>();
  const append = (jobs: readonly T[]) => {
    for (const job of jobs) {
      if (seen.has(job.jobId)) continue;
      seen.add(job.jobId);
      deck.push(job);
    }
  };
  append(newMatches);
  append(openRoles);
  return deck;
}
