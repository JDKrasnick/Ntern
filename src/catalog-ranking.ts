import type { CatalogGroupDetails, CatalogGroupRole } from './catalog-groups.js';
import { scoreOpportunity } from './opportunity-score.js';
import type { CompanySizeScores } from './company-size.js';

export function compareOpportunityRanks(left: { score: number; id: string }, right: { score: number; id: string }) {
  return right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function rankCatalogGroup(details: CatalogGroupDetails, companySizes?: CompanySizeScores): CatalogGroupDetails {
  const roles = details.roles.map(role => ({ ...role, opportunity: scoreOpportunity(role, companySizes) }))
    .sort((a, b) => compareOpportunityRanks({ score: a.opportunity.total, id: a.jobId }, { score: b.opportunity.total, id: b.jobId }));
  const featuredRole = roles[0]!;
  return { group: { ...details.group, featuredRole, opportunity: featuredRole.opportunity,
    titles: [...new Set(roles.map(role => role.title))].slice(0, 3) }, roles };
}

export function rankCatalogGroups(groups: CatalogGroupDetails[], companySizes?: CompanySizeScores) {
  return groups.map(group => rankCatalogGroup(group, companySizes)).sort((a, b) => compareOpportunityRanks(
    { score: a.group.opportunity!.total, id: a.group.groupId }, { score: b.group.opportunity!.total, id: b.group.groupId }));
}

/** Compact ranking scan input. No descriptions, provenance, source references or URLs. */
export type RankingRole = Pick<CatalogGroupRole, 'jobId' | 'company' | 'title' | 'disciplines' | 'programType' | 'compensation' | 'visibleAt' | 'releaseDay' | 'releaseDayObserved'>;
