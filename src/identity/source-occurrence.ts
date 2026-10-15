import type { SourceOccurrence } from '../types.js';
import { mergeRoleMetadataEvidence, replaceVerifiedPageMetadataEvidence } from '../role-metadata.js';
import { providerShadowRevisionChanged } from '../shadow-extraction.js';

/**
 * Source occurrences are durably stored by source and external ID. Document
 * coordinates are only identity for legacy references that predate external
 * IDs; rows can move whenever an upstream document is edited.
 */
export function sourceOccurrenceKey(value: SourceOccurrence): string {
  return value.externalId
    ? [value.sourceId, 'external', value.externalId].join('\0')
    : [value.sourceId, 'legacy-location', value.document ?? '', value.row ?? ''].join('\0');
}

function earliest(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort()[0];
}

function admissionObservedAt(admission: SourceOccurrence['admission']): string {
  if (!admission) return '';
  return [admission.evaluatedAt, admission.evidenceObservedAt, admission.destination.inspectedAt].sort().at(-1) ?? '';
}

function latestAdmission(
  previous: SourceOccurrence['admission'],
  incoming: SourceOccurrence['admission'],
): SourceOccurrence['admission'] {
  if (!previous) return incoming;
  if (!incoming) return previous;
  const previousObservedAt = admissionObservedAt(previous);
  const incomingObservedAt = admissionObservedAt(incoming);
  if (previousObservedAt > incomingObservedAt) return previous;
  if (incomingObservedAt > previousObservedAt) return incoming;
  if (previous.destination.browserVisible === true && incoming.destination.browserVisible !== true) return previous;
  return incoming;
}

export function mergeSourceOccurrence(
  previous: SourceOccurrence | undefined,
  incoming: SourceOccurrence,
): SourceOccurrence {
  const firstAttachedAt = earliest([previous?.firstAttachedAt, incoming.firstAttachedAt]);
  const providerEvidence = previous?.providerEvidence && incoming.providerEvidence
    ? {
        ...previous.providerEvidence,
        ...incoming.providerEvidence,
        urls: [...new Set([...previous.providerEvidence.urls, ...incoming.providerEvidence.urls])].sort(),
      }
    : incoming.providerEvidence ?? previous?.providerEvidence;
  const provenance = incoming.provenance ?? previous?.provenance;
  const admission = latestAdmission(previous?.admission, incoming.admission);
  const priorEvidence = previous && providerShadowRevisionChanged(previous, incoming)
    ? previous.metadataEvidence?.filter(item => item.sourceClass !== 'reviewed-shadow') : previous?.metadataEvidence;
  const metadataEvidence = incoming.metadataExtraction
    ? replaceVerifiedPageMetadataEvidence(priorEvidence, incoming.metadataEvidence, incoming.sourceId)
    : mergeRoleMetadataEvidence(priorEvidence, incoming.metadataEvidence);
  return {
    ...previous,
    ...incoming,
    ...(provenance ? { provenance } : {}),
    ...(providerEvidence ? { providerEvidence } : {}),
    ...(admission ? { admission } : {}),
    ...(metadataEvidence.length || previous?.metadataEvidence ? { metadataEvidence } : {}),
    ...(firstAttachedAt ? { firstAttachedAt } : {}),
    ...(previous?.firstAttachedAtPrecision === 'exact' || incoming.firstAttachedAtPrecision === 'exact'
      ? { firstAttachedAtPrecision: 'exact' as const }
      : previous?.firstAttachedAtPrecision || incoming.firstAttachedAtPrecision
        ? { firstAttachedAtPrecision: 'unknown' as const }
        : {}),
  };
}

export function mergeSourceOccurrenceReferences(values: SourceOccurrence[]): SourceOccurrence[] {
  const merged = new Map<string, SourceOccurrence>();
  for (const occurrence of values) {
    const key = sourceOccurrenceKey(occurrence);
    merged.set(key, mergeSourceOccurrence(merged.get(key), occurrence));
  }
  return [...merged.values()];
}
