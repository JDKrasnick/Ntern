import { describe, expect, it } from 'vitest';
import { postingFactDetails, type PostingFact } from '../../shared/posting-facts';

describe('grouped role fact tags', () => {
  it('keeps conditional and negative facts intact and deduplicates identical qualifiers', () => {
    const fact: PostingFact = { field: 'housing', statements: ['Relocation up to $4,000 if eligible', 'No housing provided'],
      qualifiers: ['No housing provided', '  '], sourceUrl: 'https://example.com/job', contentHash: 'a'.repeat(64) };
    expect(postingFactDetails([fact])).toEqual([{ field: 'housing', label: 'Housing',
      tags: ['Relocation up to $4,000 if eligible', 'No housing provided'] }]);
    expect(postingFactDetails(undefined)).toEqual([]);
    expect(postingFactDetails([{ ...fact, statements: [] }])).toEqual([]);
  });
});
