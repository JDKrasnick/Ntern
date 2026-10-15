/** Employer statements published from an exact, validated posting revision. */
export const postingFactFields = ['compensation', 'locations', 'workMode', 'housing', 'timing', 'education', 'eligibility'] as const;
export type PostingFactField = typeof postingFactFields[number];
export interface PostingFact {
  field: PostingFactField;
  statements: string[];
  qualifiers: string[];
  sourceUrl: string;
  contentHash: string;
}
export const postingFactLabels: Record<PostingFactField, string> = {
  compensation: 'Pay', locations: 'Location', workMode: 'Work mode', housing: 'Housing and relocation',
  timing: 'Dates and commitment', education: 'Education', eligibility: 'Eligibility',
};

export function postingFactDetails(facts: readonly PostingFact[] | undefined) {
  return (facts ?? []).filter(fact => postingFactFields.includes(fact.field) && fact.statements.length)
    .map(fact => ({ field: fact.field, label: postingFactLabels[fact.field],
      detail: [...new Set([...fact.statements, ...fact.qualifiers])].join(' · ') }));
}
