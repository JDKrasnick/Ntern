import { describe, expect, it } from 'vitest';
import { discoveryDeck } from '../src/discovery';

const role = (jobId: string) => ({ jobId, company: `${jobId} employer`, title: `${jobId} role`, open: true });

describe('discover deck order', () => {
  it('shows the new matches first, then the fetched open roles in their own order', () => {
    const deck = discoveryDeck([role('match-newest'), role('match-older')], [role('catalog-newest'), role('catalog-older')]);
    expect(deck.map((job) => job.jobId)).toEqual(['match-newest', 'match-older', 'catalog-newest', 'catalog-older']);
  });

  it('keeps a role that arrives in both halves once, at the new-match position', () => {
    const shared = role('shared');
    const deck = discoveryDeck([role('match'), shared], [role('shared'), role('catalog-tail')]);
    expect(deck.map((job) => job.jobId)).toEqual(['match', 'shared', 'catalog-tail']);
    expect(deck[1]).toBe(shared);
  });

  it('leaves the new matches untouched when the fetched page is empty', () => {
    const matches = [role('match-newest'), role('match-older')];
    expect(discoveryDeck(matches, [])).toEqual(matches);
  });
});
