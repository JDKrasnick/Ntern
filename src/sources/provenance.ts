import type { OccurrenceProvenance, SourceReference } from '../types.js';
import { reviewedAshbySources } from './ashby-config.js';
import { reviewedGreenhouseSources } from './greenhouse-config.js';
import { reviewedLeverSources } from './lever-config.js';

const officialSourceIds = new Set([
  ...reviewedGreenhouseSources.map((source) => source.id),
  ...reviewedLeverSources.map((source) => source.id),
  ...reviewedAshbySources.map((source) => source.id),
]);

// These are exact reviewed registry identities retained for rows written before
// occurrence provenance was introduced, including retired sources. New rows
// always persist provenance.
const reviewedCommunitySourceIds = new Set([
  'vanshb03-summer-2027',
  'simplify-summer-2026',
  'zapply-2027',
  'speedyapply-2027-swe',
  'speedyapply-2027-ai',
]);

export function occurrenceProvenance(
  reference: Pick<SourceReference, 'sourceId' | 'provenance'>,
): OccurrenceProvenance | undefined {
  if (reference.provenance) return reference.provenance;
  if (officialSourceIds.has(reference.sourceId)) return 'official-ats';
  if (reviewedCommunitySourceIds.has(reference.sourceId)) return 'reviewed-community';
  return undefined;
}

export function isOfficialOccurrence(reference: Pick<SourceReference, 'sourceId' | 'provenance'>): boolean {
  const provenance = occurrenceProvenance(reference);
  return provenance === 'official-ats' || provenance === 'official-structured';
}
