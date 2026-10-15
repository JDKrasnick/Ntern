import { describe, expect, it } from 'vitest';
import { buildShadowCohort, verifyShadowCohortProof } from '../src/shadow-cohort.js';

describe('approved historical cohort', () => {
  it('binds every odd-sized cohort member to all three exact identity parts', () => {
    const entries = Array.from({ length: 213 }, (_, i) => ({ sourceId: `greenhouse-${i % 7}`, externalId: String(i), contentHash: i.toString(16).padStart(64, '0') }));
    const cohort = buildShadowCohort(entries);
    expect(cohort.size).toBe(213);
    for (const entry of cohort.entries) {
      expect(verifyShadowCohortProof(cohort.root, entry, entry.proof)).toBe(true);
      for (const key of ['sourceId', 'externalId', 'contentHash'] as const) {
        expect(verifyShadowCohortProof(cohort.root, { ...entry, [key]: 'different' }, entry.proof)).toBe(false);
      }
    }
  });
  it('handles a single member and rejects missing, malformed and oversized proofs', () => {
    const entry = { sourceId: 'ashby-test', externalId: '123', contentHash: 'a'.repeat(64) };
    const { root } = buildShadowCohort([entry]);
    expect(verifyShadowCohortProof(root, entry, [])).toBe(true);
    for (const proof of [undefined, ['invalid'], Array(9).fill('a'.repeat(64))]) expect(verifyShadowCohortProof(root, entry, proof)).toBe(false);
    expect(() => buildShadowCohort([])).toThrow();
    expect(() => buildShadowCohort([entry, entry])).toThrow();
    expect(() => buildShadowCohort(Array.from({ length: 251 }, (_, i) => ({ ...entry, externalId: String(i) })))).toThrow();
  });
});
