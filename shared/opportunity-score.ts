export type CatalogSort = 'best' | 'newest';

export interface OpportunityScore {
  version: 'v1';
  total: number;
  company: number;
  pay: number;
  role: number;
  companyEvidence: 'reviewed' | 'unrated';
  payEvidence: 'listed' | 'unknown';
  reasons: string[];
}

export const opportunityWeights = { company: 0.45, pay: 0.30, role: 0.25 } as const;
